// SPDX-License-Identifier: MIT
import { resolve } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { realMediaTools } from '@wordedits/core';
import { startFallbackViewer } from './fallback-viewer.js';
import { createEngineServer } from './server.js';

// stdout carries the protocol: anything for people goes to stderr. A folder without mirage.json is fine: new_project makes it.
const project = resolve(process.env.MIRAGE_PROJECT || process.cwd());

createEngineServer({ project, tools: await realMediaTools() })
  .connect(new StdioServerTransport())
  .catch((e: unknown) => {
    console.error(`mirage engine: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });

startFallbackViewer(project);
