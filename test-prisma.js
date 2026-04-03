import prisma from "./packages/db/src/index.js"
console.log(globalThis.__dirname);
delete globalThis.__dirname;
console.log(globalThis.__dirname);
