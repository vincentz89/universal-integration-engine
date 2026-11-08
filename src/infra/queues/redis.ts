import dotenv from "dotenv";
import { Redis } from "ioredis";
import { logger } from "../../shared/utils/logger.js";

// Load environment variables before initializing Redis.
dotenv.config();

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL is not configured.");
}

// Initialize the Redis connection.
export const redisConnection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
  family: 4,
  retryStrategy(times) {
    const delay = Math.min(times * 500, 5000);

    logger.warn(
      { attempt: times, delay },
      "Redis connection retry scheduled."
    );

    return delay;
  },
});

// Handle Redis connection events.
redisConnection.on("connect", () => {
  logger.info("Redis connected successfully.");
});

redisConnection.on("error", (error) => {
  logger.error({ error }, "Redis connection error.");
});