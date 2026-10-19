// e2e global teardown: remove every [e2e] circle (members, texts etc. cascade).
// Auth users are Joe's two hand-made test Elfs and are never deleted here.
import { sweepCircles, withDb } from './support/project.mjs'

export default async function globalTeardown () {
  await withDb(sweepCircles)
}
