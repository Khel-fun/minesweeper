import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import prisma from "./index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log("Seeding database...");

  // 1. Create or ensure Game exists
  const game = await prisma.game.upsert({
    where: { name: "minesweeper" },
    update: {},
    create: {
      name: "minesweeper",
    },
  });
  console.log(`[db] Game initialized: ${game.name} (${game.id})`);

  // 2. Locate the circuits targets directory
  const targetDir = path.resolve(__dirname, "../../proving_system/circuits/target");

  const circuitsToSeed = ["initialize_board", "game_state"];

  for (const circuitName of circuitsToSeed) {
    console.log(`[db] Processing ${circuitName}...`);

    try {
      const jsonContent = await fs.readFile(path.join(targetDir, `${circuitName}.json`), "utf8");
      const compiledCircuit = JSON.parse(jsonContent);

      const vkHexContent = await fs.readFile(path.join(targetDir, `${circuitName}_vk.hex`), "utf8");
      
      const vkHashContent = await fs.readFile(path.join(targetDir, `${circuitName}_vkHash.json`), "utf8");
      const vkHashObj = JSON.parse(vkHashContent);
      const vkHash = vkHashObj.vkHash || vkHashObj.meta?.vkHash;

      if (!vkHash) {
        throw new Error(`vkHash not found in ${circuitName}_vkHash.json`);
      }

      // Check if circuit already exists (no @unique constraint on gameId/circuitName so findFirst is used)
      const existingCircuit = await prisma.circuit.findFirst({
        where: { gameId: game.id, circuitName },
      });

      if (existingCircuit) {
        // Update
        await prisma.circuit.update({
          where: { id: existingCircuit.id },
          data: {
            compiledCircuit,
            verificationKey: vkHexContent.trim(),
            vkHash,
          },
        });
        console.log(`[db] Updated circuit: ${circuitName}`);
      } else {
        // Create
        await prisma.circuit.create({
          data: {
            gameId: game.id,
            circuitName,
            compiledCircuit,
            verificationKey: vkHexContent.trim(),
            vkHash,
          },
        });
        console.log(`[db] Created circuit: ${circuitName}`);
      }
    } catch (e: any) {
      console.warn(`[db] Skipping circuit ${circuitName}. Error: ${e.message}`);
    }
  }

  console.log("Seeding complete.");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
