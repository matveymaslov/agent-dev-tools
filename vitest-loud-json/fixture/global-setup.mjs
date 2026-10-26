export default function setup() {
  return () => {
    if (process.env.LOUD_SCENARIO === 'late-exit') process.exitCode = 7
  }
}
