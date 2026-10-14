const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const root = path.resolve(__dirname, "..");
const publicDir = path.join(root, "frontend", "public");
const logo = fs.readFileSync(path.join(publicDir, "logo.svg"));

async function main() {
  const plate = Buffer.from(
    '<svg width="388" height="388" xmlns="http://www.w3.org/2000/svg"><rect width="388" height="388" rx="82" fill="#fffaf6"/></svg>',
  );
  const resizedLogo = await sharp(logo).resize(312, 312).png().toBuffer();
  const master = await sharp({
    create: { width: 512, height: 512, channels: 4, background: "#191818" },
  })
    .composite([
      { input: plate, left: 62, top: 62 },
      { input: resizedLogo, left: 100, top: 100 },
    ])
    .png()
    .toBuffer();

  await Promise.all([
    sharp(master).toFile(path.join(publicDir, "icon-512.png")),
    sharp(master).toFile(path.join(publicDir, "icon-maskable-512.png")),
    sharp(master).resize(192, 192).toFile(path.join(publicDir, "icon-192.png")),
    sharp(master).resize(180, 180).toFile(path.join(publicDir, "apple-touch-icon.png")),
    sharp(master).resize(32, 32).toFile(path.join(publicDir, "favicon-32.png")),
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
