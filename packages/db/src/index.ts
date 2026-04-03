import { env } from "@minesweeper/env/server";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient, GameStatus } from "@prisma/client";

const adapter = new PrismaPg({ connectionString: env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

export default prisma;
export { GameStatus };
