import { WorkflowContext, TransactionContext, Transaction, Workflow, DBOSInitializer, InitContext, CommunicatorContext, Communicator } from "../../src/";
import { generateDBOSTestConfig, setUpDBOSTestDb, TestKvTable } from "../helpers";
import { v1 as uuidv1 } from "uuid";
import { DBOSConfig } from "../../src/dbos-executor";
import { PoolClient } from "pg";
import { TestingRuntime, TestingRuntimeImpl, createInternalTestRuntime } from "../../src/testing/testing_runtime";

type TestTransactionContext = TransactionContext<PoolClient>;
const testTableName = "debugger_test_kv";

describe("debugger-test", () => {
  let username: string;
  let config: DBOSConfig;
  let debugConfig: DBOSConfig;
  let debugProxyConfig: DBOSConfig;
  let testRuntime: TestingRuntime;
  let debugRuntime: TestingRuntime;
  let debugProxyRuntime: TestingRuntime;

  beforeAll(async () => {
    config = generateDBOSTestConfig();
    debugConfig = generateDBOSTestConfig(undefined, true);
    debugProxyConfig = generateDBOSTestConfig(undefined, true, "postgresql://localhost:5432");
    username = config.poolConfig.user || "postgres";
    await setUpDBOSTestDb(config);
  });

  beforeEach(async () => {
    debugRuntime = await createInternalTestRuntime(undefined, debugConfig);
    testRuntime = await createInternalTestRuntime(undefined, config);
    debugProxyRuntime = await createInternalTestRuntime(undefined, debugProxyConfig);     // TODO: connect to the real proxy.
    DebuggerTest.cnt = 0;
  });

  afterEach(async () => {
    await debugRuntime.destroy();
    await testRuntime.destroy();
    await debugProxyRuntime.destroy();
  });

  class DebuggerTest {
    static cnt: number = 0;

    @DBOSInitializer()
    static async init(ctx: InitContext) {
      await ctx.queryUserDB(`DROP TABLE IF EXISTS ${testTableName};`);
      await ctx.queryUserDB(`CREATE TABLE IF NOT EXISTS ${testTableName} (id SERIAL PRIMARY KEY, value TEXT);`);
    }

    @Transaction({readOnly: true})
    static async testReadOnlyFunction(txnCtxt: TestTransactionContext, number: number) {
      const { rows } = await txnCtxt.client.query<{one: number}>(`SELECT 1 AS one`);
      return Number(rows[0].one) + number;
    }

    @Transaction()
    static async testFunction(txnCtxt: TestTransactionContext, name: string) {
      const { rows } = await txnCtxt.client.query<TestKvTable>(`INSERT INTO ${testTableName}(value) VALUES ($1) RETURNING id`, [name]);
      return Number(rows[0].id);
    }

    @Workflow()
    static async testWorkflow(ctxt: WorkflowContext, name: string) {
      const funcResult = await ctxt.invoke(DebuggerTest).testFunction(name);
      return funcResult;
    }

    @Communicator()
    static async testCommunicator(_ctxt: CommunicatorContext) {
      return Promise.resolve(++DebuggerTest.cnt);
    }

    @Workflow()
    static async receiveWorkflow(ctxt: WorkflowContext) {
      const message1 = await ctxt.recv<string>();
      const message2 = await ctxt.recv<string>();
      const fail = await ctxt.recv("message3", 0);
      return message1 === "message1" && message2 === "message2" && fail === null;
    }

    @Workflow()
    static async sendWorkflow(ctxt: WorkflowContext, destinationUUID: string) {
      await ctxt.send(destinationUUID, "message1");
      await ctxt.send(destinationUUID, "message2");
    }

    @Workflow()
    static async setEventWorkflow(ctxt: WorkflowContext) {
      await ctxt.setEvent("key1", "value1");
      await ctxt.setEvent("key2", "value2");
      return 0;
    }

    @Workflow()
    static async getEventWorkflow(ctxt: WorkflowContext, targetUUID: string) {
      const val1 = await ctxt.getEvent<string>(targetUUID, "key1");
      const val2 = await ctxt.getEvent<string>(targetUUID, "key2");
      return val1 + "-" + val2;
    }

    @Transaction()
    static async voidFunction(_txnCtxt: TestTransactionContext) {
      if (DebuggerTest.cnt > 0) {
        return Promise.resolve(DebuggerTest.cnt);
      }
      DebuggerTest.cnt++;
      return;
    }

    // Workflow with different results.
    @Workflow()
    static async diffWorkflow(_ctxt: WorkflowContext, num: number) {
      DebuggerTest.cnt += num;
      return Promise.resolve(DebuggerTest.cnt);
    }

    // Workflow that sleep
    @Workflow()
    static async sleepWorkflow(ctxt: WorkflowContext, num: number) {
      await ctxt.sleep(1)
      const funcResult = await ctxt.invoke(DebuggerTest).testReadOnlyFunction(num);
      return funcResult;
    }
  }

  test("debug-workflow", async () => {
    const wfUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    const res = await testRuntime
      .invokeWorkflow(DebuggerTest, wfUUID)
      .testWorkflow(username);
    expect(res).toBe(1);
    await testRuntime.destroy();

    // Execute again in debug mode.
    const debugRes = await debugRuntime
      .invokeWorkflow(DebuggerTest, wfUUID)
      .testWorkflow(username);
    expect(debugRes).toBe(1);

    // Execute again with the provided UUID.
    await expect((debugRuntime as TestingRuntimeImpl).getDBOSExec().executeWorkflowUUID(wfUUID).then((x) => x.getResult())).resolves.toBe(1);

    await expect((debugProxyRuntime as TestingRuntimeImpl).getDBOSExec().executeWorkflowUUID(wfUUID).then((x) => x.getResult())).resolves.toBe(1);

    // Execute a non-exist UUID should fail.
    const wfUUID2 = uuidv1();
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID2).testWorkflow(username)).rejects.toThrow("Workflow status or inputs not found!");

    // Execute a workflow without specifying the UUID should fail.
    await expect(debugRuntime.invoke(DebuggerTest).testWorkflow(username)).rejects.toThrow("Workflow UUID not found!");
  });

  test("debug-sleep-workflow", async () => {
    const wfUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    const res = await testRuntime
      .invokeWorkflow(DebuggerTest, wfUUID)
      .sleepWorkflow(2);
    expect(res).toBe(3);
    await testRuntime.destroy();

    // Execute again in debug mode, should return the correct value
    const debugRes = await debugRuntime
      .invokeWorkflow(DebuggerTest, wfUUID)
      .sleepWorkflow(2);
    expect(debugRes).toBe(3);

    // Proxy mode should return the same result
    const debugProxyRes = await debugProxyRuntime
      .invokeWorkflow(DebuggerTest, wfUUID)
      .sleepWorkflow(2);
    expect(debugProxyRes).toBe(3);
  });

  test("debug-void-transaction", async () => {
    const wfUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    await expect(testRuntime.invoke(DebuggerTest, wfUUID).voidFunction()).resolves.toBeUndefined();
    expect(DebuggerTest.cnt).toBe(1);
    await testRuntime.destroy();

    // Execute again in debug mode.
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID).voidFunction()).resolves.toBeFalsy();
    expect(DebuggerTest.cnt).toBe(1);

    // Execute again with the provided UUID.
    await expect((debugRuntime as TestingRuntimeImpl).getDBOSExec().executeWorkflowUUID(wfUUID).then((x) => x.getResult())).resolves.toBeFalsy();
    expect(DebuggerTest.cnt).toBe(1);
  });

  test("debug-transaction", async () => {
    const wfUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    await expect(testRuntime.invoke(DebuggerTest, wfUUID).testFunction(username)).resolves.toBe(1);
    await testRuntime.destroy();

    // Execute again in debug mode.
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID).testFunction(username)).resolves.toBe(1);

    // Execute again with the provided UUID.
    await expect((debugRuntime as TestingRuntimeImpl).getDBOSExec().executeWorkflowUUID(wfUUID).then((x) => x.getResult())).resolves.toBe(1);

    // Proxy mode should return the same result.
    await expect((debugProxyRuntime as TestingRuntimeImpl).getDBOSExec().executeWorkflowUUID(wfUUID).then((x) => x.getResult())).resolves.toBe(1);

    // Execute a non-exist UUID should fail.
    const wfUUID2 = uuidv1();
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID2).testFunction(username)).rejects.toThrow("Workflow status or inputs not found!");

    // Execute a workflow without specifying the UUID should fail.
    await expect(debugRuntime.invoke(DebuggerTest).testFunction(username)).rejects.toThrow("Workflow UUID not found!");
  });

  test("debug-read-only-transaction", async () => {
    const wfUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    await expect(testRuntime.invoke(DebuggerTest, wfUUID).testReadOnlyFunction(1)).resolves.toBe(2);
    await testRuntime.destroy();

    // Execute again in debug mode.
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID).testReadOnlyFunction(1)).resolves.toBe(2);

    // Execute again with the provided UUID.
    await expect((debugRuntime as TestingRuntimeImpl).getDBOSExec().executeWorkflowUUID(wfUUID).then((x) => x.getResult())).resolves.toBe(2);

    // Proxy mode should return the same result.
    await expect((debugProxyRuntime as TestingRuntimeImpl).getDBOSExec().executeWorkflowUUID(wfUUID).then((x) => x.getResult())).resolves.toBe(2);

    // Execute a non-exist UUID should fail.
    const wfUUID2 = uuidv1();
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID2).testReadOnlyFunction(1)).rejects.toThrow("Workflow status or inputs not found!");

    // Execute a workflow without specifying the UUID should fail.
    await expect(debugRuntime.invoke(DebuggerTest).testReadOnlyFunction(1)).rejects.toThrow("Workflow UUID not found!");
  });

  test("debug-communicator", async () => {
    const wfUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    await expect(testRuntime.invoke(DebuggerTest, wfUUID).testCommunicator()).resolves.toBe(1);
    await testRuntime.destroy();

    // Execute again in debug mode.
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID).testCommunicator()).resolves.toBe(1);

    // Execute again with the provided UUID.
    await expect((debugRuntime as TestingRuntimeImpl).getDBOSExec().executeWorkflowUUID(wfUUID).then((x) => x.getResult())).resolves.toBe(1);

    // Execute a non-exist UUID should fail.
    const wfUUID2 = uuidv1();
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID2).testCommunicator()).rejects.toThrow("Workflow status or inputs not found!");

    // Execute a workflow without specifying the UUID should fail.
    await expect(debugRuntime.invoke(DebuggerTest).testCommunicator()).rejects.toThrow("Workflow UUID not found!");
  });

  test("debug-workflow-notifications", async() => {
    const recvUUID = uuidv1();
    const sendUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    const handle = await testRuntime.invoke(DebuggerTest, recvUUID).receiveWorkflow();
    await expect(testRuntime.invokeWorkflow(DebuggerTest, sendUUID).sendWorkflow(recvUUID)).resolves.toBeFalsy(); // return void.
    expect(await handle.getResult()).toBe(true);
    await testRuntime.destroy();

    // Execute again in debug mode.
    await expect(debugRuntime.invokeWorkflow(DebuggerTest, recvUUID).receiveWorkflow()).resolves.toBe(true);
    await expect(debugRuntime.invokeWorkflow(DebuggerTest, sendUUID).sendWorkflow(recvUUID, )).resolves.toBeFalsy();
  });

  test("debug-workflow-events", async() => {
    const getUUID = uuidv1();
    const setUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    await expect(testRuntime.invokeWorkflow(DebuggerTest, setUUID).setEventWorkflow()).resolves.toBe(0);
    await expect(testRuntime.invokeWorkflow(DebuggerTest, getUUID).getEventWorkflow(setUUID, )).resolves.toBe("value1-value2");
    await testRuntime.destroy();

    // Execute again in debug mode.
    await expect(debugRuntime.invokeWorkflow(DebuggerTest, setUUID).setEventWorkflow()).resolves.toBe(0);
    await expect(debugRuntime.invokeWorkflow(DebuggerTest, getUUID).getEventWorkflow(setUUID)).resolves.toBe("value1-value2");
  });

  test("debug-workflow-input-output", async() => {
    const wfUUID = uuidv1();
    // Execute the workflow and destroy the runtime
    const res = await testRuntime.invokeWorkflow(DebuggerTest, wfUUID).diffWorkflow(1);
    expect(res).toBe(1);
    await testRuntime.destroy();

    // Execute again with the provided UUID, should still get the same output.
    await expect((debugRuntime as TestingRuntimeImpl).getDBOSExec().executeWorkflowUUID(wfUUID).then((x) => x.getResult())).resolves.toBe(1);
    expect(DebuggerTest.cnt).toBe(2);

    // Execute again with different input, should still get the same output.
    await expect(debugRuntime.invoke(DebuggerTest, wfUUID).diffWorkflow(2)).rejects.toThrow("Detect different input for the workflow");
  })
});
