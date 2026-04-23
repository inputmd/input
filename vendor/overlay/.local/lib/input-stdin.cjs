'use strict';

function toBuffer(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

async function readStdinBuffer(stdin) {
  if (stdin == null) {
    return Buffer.alloc(0);
  }

  const chunks = [];
  for await (const chunk of stdin) {
    chunks.push(toBuffer(chunk));
  }
  return Buffer.concat(chunks);
}

async function readStdinText(stdin) {
  return (await readStdinBuffer(stdin)).toString('utf8');
}

module.exports = {
  readStdinBuffer,
  readStdinText,
};
