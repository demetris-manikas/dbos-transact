import { DBOSExecutor } from "./dbos-executor";
import { DBOSInitializationError } from "./error";

/**
 Limit the maximum number of functions from this queue
   that can be started in a given period.
 If the limit is 5 and the period is 10, no more than 5 functions can be
   started per 10 seconds.
*/
interface QueueRateLimit {
    limitPerPeriod: number;
    periodSec: number;
}

export class WorkflowQueue {
    constructor(readonly name: string, readonly concurrency?: number, readonly rateLimit?: QueueRateLimit) {
        if (wfQueueRunner.wfQueuesByName.has(name)) {
            throw new DBOSInitializationError(`Workflow Queue '${name}' defined multiple times`);
        }
        wfQueueRunner.wfQueuesByName.set(name, this);
    }
}

class WFQueueRunner
{
    readonly wfQueuesByName: Map<string, WorkflowQueue> = new Map();

    private isRunning: boolean = false;
    private interruptResolve?: () => void;

    stop() {
        if (!this.isRunning) return;
        this.isRunning = false;
        if (this.interruptResolve) {
            this.interruptResolve();
        }
    }

    async dispatchLoop(exec: DBOSExecutor): Promise<void> {
        this.isRunning = true;
        while (this.isRunning) {
            // Wait for either the timeout or an interruption
            let timer: NodeJS.Timeout;
            const timeoutPromise = new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                    resolve();
                }, 1000);
            });

            await Promise.race([
                timeoutPromise,
                new Promise<void>((_, reject) => this.interruptResolve = reject)
            ])
            .catch(() => {exec.logger.debug("Workflow queue loop interrupted!")}); // Interrupt sleep throws
                clearTimeout(timer!);

            if (!this.isRunning) {
                break;
            }

            // Check queues
            for (const [_qn, q] of this.wfQueuesByName) {
                const wfids = await exec.systemDatabase.findAndMarkStartableWorkflows(q);
                for (const wfid of wfids) {
                    const _wfh = await exec.executeWorkflowUUID(wfid);
                }
            }
        }
    }

    logRegisteredEndpoints(exec: DBOSExecutor) {
        const logger = exec.logger;
        logger.info("Workflow queues:");
        for (const [qn, q] of this.wfQueuesByName) {
            const conc = q.concurrency !== undefined ? `${q.concurrency}` : 'No concurrency limit set';
            logger.info(`    ${qn}: ${conc}`);
        }
    }
}

export const wfQueueRunner = new WFQueueRunner();
