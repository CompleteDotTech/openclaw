// The workflow invokes offline scripts with one built PR checkout argument.
process.argv.push('--compare');
await import('./dictation-proof.mjs');
