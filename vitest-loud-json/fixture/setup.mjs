Promise.reject(new Error('Unhandled setup rejection: background work failed'))
// Give Node's unhandledRejection event time to reach Vitest before finishing.
await new Promise(setImmediate)
