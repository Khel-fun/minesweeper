import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { env } from "@minesweeper/env/server";
import prisma from "@minesweeper/db";
import { queryKurierStatus } from "@minesweeper/proving_system/prove";

const connection = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
});

export const KURIER_SYNC_QUEUE_NAME = "kurier-status-sync";

// 1. Setup the queue for repeatable jobs
export const kurierSyncQueue = new Queue(KURIER_SYNC_QUEUE_NAME, {
  connection,
});

// 2. Schedule the recurring job every 3 minutes
export async function scheduleKurierSync() {
  console.log(`[KurierSync] Scheduling Kurier sync job...`);
  await kurierSyncQueue.add(
    "sync-job",
    {}, // no payload needed, runs globally against db
    {
      repeat: {
        every: 180000, // 3 minutes = 180,000 ms
      },
      jobId: "kurier-sync-repeater", // Ensure only one repeatable job is registered
    },
  );
}

// 3. Worker logic
export function initKurierSyncWorker() {
  console.log(`[KurierSync] Initializing Kurier sync worker`);

  const worker = new Worker(
    KURIER_SYNC_QUEUE_NAME,
    async (job) => {
      console.log(`[KurierSync Worker] Job ${job.id} started.`);
      
      // We want to skip jobs that are in terminal states
      const jobsToSync = await prisma.verificationJob.findMany({
        where: {
          OR: [
            { verificationStatus: null },
            {
              verificationStatus: {
                notIn: ["AGGREGATED", "FAILED"], // Terminal states to ignore
              },
            },
          ],
        },
      });

      console.log(`[KurierSync Worker] Found ${jobsToSync.length} jobs to sync.`);

      const saveableStatuses = [
        "FINALIZED",
        "AGGREGATION_PENDING",
        "AGGREGATED",
        "FAILED",
      ];

      // Query them individually as requested
      for (const verificationJob of jobsToSync) {
        try {
          const statusResult = await queryKurierStatus(verificationJob.kurierJobId);
          
          // Map to uppercase prisma enum representation
          let prismaStatus = statusResult.verificationStatus.toUpperCase() as any;
          if (statusResult.verificationStatus === "IncludedInBlock") {
            prismaStatus = "INCLUDED_IN_BLOCK";
          } else if (statusResult.verificationStatus === "AggregationPending") {
            prismaStatus = "AGGREGATION_PENDING";
          }

          if (saveableStatuses.includes(prismaStatus)) {
            console.log(
              `[KurierSync Worker] Job ${verificationJob.kurierJobId} reached saveable state ${prismaStatus}. Updating DB.`
            );
            
            await prisma.verificationJob.update({
              where: { kurierJobId: verificationJob.kurierJobId },
              data: {
                verificationStatus: prismaStatus,
                txHash: statusResult.txHash,
                aggregationId: statusResult.aggregationId,
                aggregationDetails: (statusResult.aggregationDetails as any) ?? undefined,
              },
            });
          } else {
            console.log(
              `[KurierSync Worker] Job ${verificationJob.kurierJobId} status is ${prismaStatus} (not finalized yet). Skipping DB update.`
            );
          }
        } catch (error) {
          console.error(
            `[KurierSync Worker] Failed to correctly sync job ${verificationJob.kurierJobId}`,
            error
          );
        }
      }

      console.log(`[KurierSync Worker] Sync cycle completed.`);
    },
    {
      connection,
      concurrency: 1, // safe concurrency for this background task
    }
  );

  worker.on("error", (err) => {
    console.error(`[KurierSync Worker] Uncaught error:`, err);
  });

  return worker;
}

export async function initKurierPoller() {
  await scheduleKurierSync();
  initKurierSyncWorker();
}
