// [fb-reels-patch] Replace the mp4 branch of FacebookProvider.post with the Reels-API
// version in fb-reels-block.js. Anchor-based so it refuses to guess if the compiled
// output ever changes shape (e.g. after an image pull).
const fs = require('fs');

const [, , target, blockFile] = process.argv;
if (!target || !blockFile) {
  console.error('usage: fb-reels-apply.js <provider.js> <block.js>');
  process.exit(2);
}

const src = fs.readFileSync(target, 'utf8');
const block = fs.readFileSync(blockFile, 'utf8');

const START =
  "        else if ((0, has_extension_1.hasExtension)(firstPost?.media?.[0]?.path, 'mp4')) {\n";
const END =
  "            finalUrl = 'https://www.facebook.com/reel/' + videoId;\n" +
  '            finalId = videoId;\n' +
  '        }\n';

const si = src.indexOf(START);
if (si === -1) {
  console.error('start anchor not found');
  process.exit(1);
}
if (src.indexOf(START, si + 1) !== -1) {
  console.error('start anchor is ambiguous');
  process.exit(1);
}
const ei = src.indexOf(END, si);
if (ei === -1) {
  console.error('end anchor not found');
  process.exit(1);
}

const out = src.slice(0, si) + block + src.slice(ei + END.length);
if (out === src) {
  console.error('replacement was a no-op');
  process.exit(1);
}
fs.writeFileSync(target, out);
console.log('replaced ' + (ei + END.length - si) + ' bytes with ' + block.length);
