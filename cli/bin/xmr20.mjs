#!/usr/bin/env node
import {main} from '../src/cli.mjs';
import {UserError,safeText} from '../src/errors.mjs';
process.umask(0o077);
try{await main(process.argv.slice(2));}
catch(error){
 // Never print library exceptions, stack traces or anything typed at a prompt.
 console.error(error instanceof UserError?safeText(error.message):'The operation could not complete. Your wallet and saved operations are kept. Run "xmr20 doctor" or see cli/README.md.');
 process.exitCode=1;
}
