import { readFileSync } from 'node:fs';

const BUILD_IDENTITY_PATH = '/usr/share/squadjs/build-identity.json';
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/;
const WORKFLOW_RUN_ID_PATTERN = /^[1-9][0-9]*$/;
const WORKFLOW_RUN_ATTEMPT_PATTERN = /^[1-9][0-9]*$/;

export function parseBuildIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;

  const commitSha = value.commitSha;
  const workflowRunId = value.workflowRunId;
  const workflowRunAttempt = value.workflowRunAttempt;
  if (
    typeof commitSha !== 'string' ||
    !COMMIT_SHA_PATTERN.test(commitSha) ||
    typeof workflowRunId !== 'string' ||
    !WORKFLOW_RUN_ID_PATTERN.test(workflowRunId) ||
    typeof workflowRunAttempt !== 'string' ||
    !WORKFLOW_RUN_ATTEMPT_PATTERN.test(workflowRunAttempt)
  ) {
    return null;
  }

  return Object.freeze({ commitSha, workflowRunId, workflowRunAttempt });
}

export function readBuildIdentity() {
  try {
    return parseBuildIdentity(JSON.parse(readFileSync(BUILD_IDENTITY_PATH, 'utf8')));
  } catch {
    return null;
  }
}
