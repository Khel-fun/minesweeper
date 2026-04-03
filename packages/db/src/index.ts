import { env } from "@minesweeper/env/server";
import { PrismaPg } from "@prisma/adapter-pg";

export * from "../prisma/generated/prisma/client";
import { PrismaClient } from "../prisma/generated/prisma/client";

// Prisma's generated client pollutes the global scope with `__dirname` in ESM.
// This breaks @aztec/bb.js, which checks `typeof __dirname !== "undefined"`.
// We unset it here immediately after importing the Prisma client.
if ('__dirname' in globalThis) {
  delete (globalThis as any).__dirname;
}

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

export default prisma;
