import {
  closeSync, fsyncSync, linkSync, openSync, readFileSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import {
  commitWriteThroughFiles,
} from '../../src/core/brain-repo-durability.ts';

type Manifest = {
  repo: string;
  sourceId: string;
  slug: string;
  relPath: string;
  absPath: string;
  sha256: string;
  expectedRef: string;
  expectedHead: string;
  routeEpoch: string;
  journalPath: string;
};

const manifestPath = process.argv[2];
if (!manifestPath) throw new Error('missing manifest');
const m = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

const fsyncParent = (file: string): void => {
  const fd = openSync(dirname(file), 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
};

commitWriteThroughFiles(
  m.repo,
  [{ absPath: m.absPath, expectedSha256: m.sha256 }],
  `gbrain: converge canonical page planes (${m.sourceId})`,
  {
    expectedRef: m.expectedRef,
    expectedHead: m.expectedHead,
    beforePublish: ({
      commitSha,
      treeSha,
      indexLeaseIdentity,
      publicationNonce,
    }) => {
      const receipt = {
        version: 5,
        sourceId: m.sourceId,
        expectedRef: m.expectedRef,
        preHead: m.expectedHead,
        expectedCommit: commitSha,
        expectedTree: treeSha,
        routeEpoch: m.routeEpoch,
        storageConfigFingerprint: { kind: 'missing' },
        indexLeaseIdentity,
        publicationNonce,
        commitPaths: [m.relPath],
        files: [{
          sourceId: m.sourceId,
          slug: m.slug,
          relPath: m.relPath,
          sha256: m.sha256,
        }],
      };
      const tmp = `${m.journalPath}.child-${process.pid}`;
      const fd = openSync(tmp, 'wx', 0o600);
      try {
        writeFileSync(fd, `${JSON.stringify(receipt)}\n`, 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      linkSync(tmp, m.journalPath); // exact production no-overwrite publication
      fsyncParent(m.journalPath);
      unlinkSync(tmp);
      fsyncParent(m.journalPath);
    },
    _afterRefPublishForTest: () => {
      process.kill(process.pid, 'SIGKILL');
      throw new Error('SIGKILL unexpectedly returned');
    },
  },
);
throw new Error('publisher unexpectedly survived SIGKILL seam');
