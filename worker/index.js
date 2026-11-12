/* ==========================================================================
   SpeakPower Studio API: the Worker's entry point.

   worker.js is the API (every route, the cron, the business rules). This
   file adds what plain Node cannot load, so the Node test suite can keep
   importing worker.js directly: the Transcriber's Workflow class, which
   runs the background job in worker.js (runTranscription) step by step.
   ========================================================================== */

import { WorkflowEntrypoint } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import api, { runTranscription } from "./worker.js";

export class TranscribeWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return runTranscription(this.env, event.payload, step, { NonRetryableError });
  }
}

export default api;
