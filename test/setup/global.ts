/**
 * Vitest global setup: work done once per run, in Node, before any worker
 * starts.
 *
 * Only one thing lives here, and it earns its place by cost. Every file that
 * signs a pass needs a certificate chain, and building one means generating
 * two 2048-bit RSA keys in pure JavaScript. Each file runs in its own isolated
 * worker, so a chain memoized inside a file was rebuilt by every file that
 * used one. Built here, it is made once and handed to each file with
 * `provide`; `getTestCertChain()` picks it up with `inject`.
 */

import type { TestProject } from "vitest/node";
import { buildTestCertChain, type TestCertChain } from "../fixtures/certChain";

declare module "vitest" {
  export interface ProvidedContext {
    testCertChain: TestCertChain;
  }
}

export default function setup(project: TestProject): void {
  project.provide("testCertChain", buildTestCertChain());
}
