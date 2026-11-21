// The scoring rules live in ../pb-engine.js (top level, so the app gets the same code); the server imports them from here.
// tools/api-check.mjs still replays the same rally sequences through the app's pasted copy and compares every state.
export * from '../pb-engine.js';
