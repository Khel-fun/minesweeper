import prisma from "./packages/db/src/index";
console.log("Before delete: ", globalThis.__dirname);
delete globalThis.__dirname;
console.log("After delete: ", globalThis.__dirname);
async function test() {
  const count = await prisma.player.count();
  console.log("Player count: ", count);
}
test().catch(e => console.error(e));
