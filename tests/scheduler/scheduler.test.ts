import { Scheduled, SchedulerMode, TestingRuntime, Workflow, WorkflowContext } from "../../src";
import { DBOSConfig } from "../../src/dbos-executor";
import { createInternalTestRuntime } from "../../src/testing/testing_runtime";
import { sleepms } from "../../src/utils";
import { generateDBOSTestConfig, setUpDBOSTestDb } from "../helpers";

describe("scheduled-wf-tests", () => {
    let config: DBOSConfig;
    let testRuntime: TestingRuntime;
  
    beforeAll(async () => {
        config = generateDBOSTestConfig();
        await setUpDBOSTestDb(config);  
    });
  
    beforeEach(async () => {
        testRuntime = await createInternalTestRuntime(undefined, config);
    });
  
    afterEach(async () => {
        await testRuntime.destroy();
    }, 10000);
  
    test("wf-scheduled", async () => {
        await sleepms(3000);
        expect(DBOSSchedTestClass.nCalls).toBeGreaterThanOrEqual(2);
        expect(DBOSSchedTestClass.nTooEarly).toBe(0);
        expect(DBOSSchedTestClass.nTooLate).toBe(0);
    });
});

class DBOSSchedTestClass {
    static nCalls = 0;
    static nTooEarly = 0;
    static nTooLate = 0;

    @Scheduled({crontab: '* * * * * *', mode: SchedulerMode.ExactlyOncePerIntervalWhenActive})
    @Workflow()
    static async scheduledDefault(ctxt: WorkflowContext, schedTime: Date, startTime: Date) {
        DBOSSchedTestClass.nCalls++;

        if (schedTime.getTime() > startTime.getTime()) DBOSSchedTestClass.nTooEarly++;
        if (startTime.getTime() - schedTime.getTime() > 1500) DBOSSchedTestClass.nTooLate++;

        await ctxt.sleepms(2000);
    }

    // This should run every 30 minutes. Making sure the testing runtime can correctly exit within a reasonable time.
    @Scheduled({crontab: '*/30 * * * *'})
    @Workflow()
    static async scheduledLong(ctxt: WorkflowContext, _schedTime: Date, _startTime: Date) {
        await ctxt.sleepms(100);
    }
}
