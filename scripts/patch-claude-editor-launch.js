import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const cliPath = path.resolve(
  __dirname,
  '../vendor/overlay/.local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
);

const before =
  'try{let A=cTY[z]??z;return P06(`${A} "${q}"`,{stdio:"inherit"}),{content:K.readFileSync(q,{encoding:"utf-8"})}}catch(A){if(typeof A==="object"&&A!==null&&"status"in A&&typeof A.status==="number"){let O=A.status;if(O!==0)return{content:null,error:`${tj(z)} exited with code ${O}`}}return{content:null}}finally{if(Y)_.exitAlternateScreen();else _.resumeStdin(),_.resume()}}';

const after =
  'try{let A=cTY[z]??z,B=A.split(" "),E=B[0]??A,R=B.slice(1),x;if(process.platform==="win32")x=RRK(`${A} "${q}"`,{stdio:"inherit",shell:!0});else x=RRK(E,[...R,q],{stdio:"inherit"});if(x.error)throw x.error;if(typeof x.status==="number"&&x.status!==0)throw{status:x.status};return{content:K.readFileSync(q,{encoding:"utf-8"})}}catch(A){if(typeof A==="object"&&A!==null&&"status"in A&&typeof A.status==="number"){let O=A.status;if(O!==0)return{content:null,error:`${tj(z)} exited with code ${O}`}}return{content:null}}finally{if(Y)_.exitAlternateScreen();else _.resumeStdin(),_.resume()}}';

const current = fs.readFileSync(cliPath, 'utf8');

if (current.includes(after)) {
  console.log('Claude editor launcher already patched.');
  process.exit(0);
}

if (!current.includes(before)) {
  console.error('Expected Claude editor launcher snippet not found.');
  process.exit(1);
}

fs.writeFileSync(cliPath, current.replace(before, after), 'utf8');
console.log(`Patched Claude editor launcher in ${cliPath}`);
