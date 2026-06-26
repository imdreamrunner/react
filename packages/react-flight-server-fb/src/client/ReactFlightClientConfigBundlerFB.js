/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {
  Thenable,
  FulfilledThenable,
  RejectedThenable,
  ReactDebugInfo,
  ReactIOInfo,
  ReactAsyncInfo,
} from 'shared/ReactTypes';

import type {ModuleLoading} from 'react-client/src/ReactFlightClientConfig';

import {canUseDOM} from 'shared/ExecutionEnvironment';

import hasOwnProperty from 'shared/hasOwnProperty';

export type ServerConsumerModuleMap = null;

export type ServerManifest = null;

export type ServerReferenceId = string;

import {prepareDestinationForModuleImpl} from 'react-client/src/ReactFlightClientConfig';

export opaque type ClientReferenceMetadata = {
  $$typeof: symbol,
  $$id: string,
  $$hblp: mixed,
};

// eslint-disable-next-line no-unused-vars
export opaque type ClientReference<T> = {
  $$typeof: symbol,
  $$id: string,
  $$hblp: mixed,
};

export function prepareDestinationForModule(
  moduleLoading: ModuleLoading,
  nonce: ?string,
  metadata: ClientReferenceMetadata,
) {
  prepareDestinationForModuleImpl(moduleLoading, metadata.$$hblp, nonce);
}

export function resolveClientReference<T>(
  bundlerConfig: ServerConsumerModuleMap,
  metadata: ClientReferenceMetadata,
): ClientReference<T> {
  return metadata;
}

// Called on the server when decoding a client's action reply (via decodeReply).
// Maps the $$id string sent by the client back to module metadata so the server
// can locate and execute the actual function. $$hblp is null because this runs
// on the server — there is no client module to download.
export function resolveServerReference<T>(
  config: ServerManifest,
  id: ServerReferenceId,
): ClientReference<T> {
  return {
    $$typeof: Symbol.for('react.client.reference'),
    $$id: id,
    $$hblp: null,
  } as any;
}

const asyncModuleCache: Map<string, Thenable<any>> = new Map();

// A Server Reference id is "moduleName#exportName"; a Client Reference id is the
// bare module name. JSResource is keyed by module name, so strip any export.
function getModuleName(id: string): string {
  const idx = id.lastIndexOf('#');
  return idx === -1 ? id : id.slice(0, idx);
}

// Select the referenced value from a loaded module. Client References resolve to
// the whole module; Server References resolve to a named export.
function selectModuleExport<T>(moduleExports: any, id: string): T {
  const idx = id.lastIndexOf('#');
  if (idx === -1) {
    return moduleExports;
  }
  const exportName = id.slice(idx + 1);
  if (exportName === '' || exportName === 'default') {
    return moduleExports.__esModule ? moduleExports.default : moduleExports;
  }
  // Read only the module's own exports so an id cannot reach prototype-chain
  // properties (e.g. the Function constructor).
  if (hasOwnProperty.call(moduleExports, exportName)) {
    return moduleExports[exportName];
  }
  return undefined as any;
}

function trackModulePromise(id: string, modulePromise: Thenable<any>): void {
  modulePromise.then(
    value => {
      const fulfilledThenable: FulfilledThenable<mixed> = modulePromise as any;
      fulfilledThenable.status = 'fulfilled';
      fulfilledThenable.value = value;
    },
    reason => {
      const rejectedThenable: RejectedThenable<mixed> = modulePromise as any;
      rejectedThenable.status = 'rejected';
      rejectedThenable.reason = reason;
    },
  );
  asyncModuleCache.set(id, modulePromise);
}

export function preloadModule<T>(
  metadata: ClientReference<T>,
): null | Thenable<any> {
  if (!canUseDOM) {
    // On the server we no longer assume modules are synchronously require()-able.
    // A HaaS 2.0 session can load Haste modules on demand via the bootloader
    // installed by HaaSUtils.enableJSResourceLoading(), so kick off an async
    // JSResource load and let the consumer block on this chunk until it resolves.
    // $FlowFixMe[cannot-resolve-module] JSResource is a Meta-internal module
    const serverJsr: any = require('JSResource')(getModuleName(metadata.$$id));
    if (serverJsr.getModuleIfRequireable() != null) {
      // Already evaluated in this session; requireModule can read it synchronously.
      return null;
    }
    const serverModulePromise: Thenable<T> = serverJsr.load();
    trackModulePromise(metadata.$$id, serverModulePromise);
    return serverModulePromise;
  }

  // $FlowFixMe[cannot-resolve-module] JSResource is a Meta-internal module
  const jsr: any = require('JSResource')(metadata.$$id);

  const previouslyLoadedModule = jsr.getModuleIfRequireable();
  if (previouslyLoadedModule != null) {
    return null;
  }

  if (metadata.$$hblp != null) {
    // Register our updates with the bootloader.
    window.Bootloader.handlePayload(metadata.$$hblp);
  }

  const modulePromise: Thenable<T> = jsr.load();
  trackModulePromise(metadata.$$id, modulePromise);
  return modulePromise;
}

export function requireModule<T>(metadata: ClientReference<T>): T {
  if (!canUseDOM) {
    // Read the module preloadModule made available — synchronously if it was
    // already evaluated, otherwise from the resolved async JSResource load.
    const id = metadata.$$id;
    // $FlowFixMe[cannot-resolve-module] JSResource is a Meta-internal module
    const serverJsr: any = require('JSResource')(getModuleName(id));
    let moduleExports = serverJsr.getModuleIfRequireable();
    if (moduleExports == null) {
      const promise: any = asyncModuleCache.get(id);
      if (promise != null && promise.status === 'fulfilled') {
        moduleExports = promise.value;
      } else if (promise != null) {
        throw promise.reason;
      } else {
        throw new Error(
          'Could not require module "' + id + '" because it was not preloaded.',
        );
      }
    }
    return selectModuleExport(moduleExports, id);
  }

  // $FlowFixMe[cannot-resolve-module] JSResource is a Meta-internal module
  const jsr: any = require('JSResource')(metadata.$$id);

  const moduleExports = jsr.getModuleIfRequireable();
  if (moduleExports != null) {
    return moduleExports;
  }

  // Fall back to the async cache if JSResource doesn't have it yet.
  const promise: any = asyncModuleCache.get(metadata.$$id);
  if (promise && promise.status === 'fulfilled') {
    return promise.value;
  } else {
    throw promise.reason;
  }
}

// We cache ReactIOInfo across requests so that inner refreshes can dedupe with outer.
const moduleIOInfoCache: Map<string, ReactIOInfo> = __DEV__
  ? new Map()
  : (null as any);

export function getModuleDebugInfo<T>(
  metadata: ClientReference<T>,
): null | ReactDebugInfo {
  if (!__DEV__) {
    return null;
  }
  const filename = metadata.$$id;
  let ioInfo = moduleIOInfoCache.get(filename);
  if (ioInfo === undefined) {
    let href;
    try {
      // $FlowFixMe[incompatible-type]
      href = new URL(filename, document.baseURI).href;
    } catch (_) {
      href = filename;
    }
    let start = -1;
    let end = -1;
    let byteSize = 0;
    // $FlowFixMe[method-unbinding]
    if (typeof performance.getEntriesByType === 'function') {
      // We may be able to collect the start and end time of this resource from Performance Observer.
      const resourceEntries = performance.getEntriesByType('resource');
      for (let i = 0; i < resourceEntries.length; i++) {
        const resourceEntry = resourceEntries[i];
        if (resourceEntry.name === href) {
          start = resourceEntry.startTime;
          end = start + resourceEntry.duration;
          // $FlowFixMe[prop-missing]
          byteSize = (resourceEntry.transferSize as any) || 0;
        }
      }
    }
    const value = Promise.resolve(href);
    // $FlowFixMe[prop-missing]
    value.status = 'fulfilled';
    // Is there some more useful representation for the chunk?
    // $FlowFixMe[prop-missing]
    value.value = href;
    // Create a fake stack frame that points to the beginning of the chunk. This is
    // probably not source mapped so will link to the compiled source rather than
    // any individual file that goes into the chunks.
    const fakeStack = new Error('react-stack-top-frame');
    if (fakeStack.stack.startsWith('Error: react-stack-top-frame')) {
      // Looks like V8
      fakeStack.stack =
        'Error: react-stack-top-frame\n' +
        // Add two frames since we always trim one off the top.
        '    at Client Component Bundle (' +
        href +
        ':1:1)\n' +
        '    at Client Component Bundle (' +
        href +
        ':1:1)';
    } else {
      // Looks like Firefox or Safari.
      // Add two frames since we always trim one off the top.
      fakeStack.stack =
        'Client Component Bundle@' +
        href +
        ':1:1\n' +
        'Client Component Bundle@' +
        href +
        ':1:1';
    }
    ioInfo = {
      name: 'script',
      start: start,
      end: end,
      value: value,
      debugStack: fakeStack,
    } as ReactIOInfo;
    if (byteSize > 0) {
      // $FlowFixMe[cannot-write]
      ioInfo.byteSize = byteSize;
    }
    moduleIOInfoCache.set(filename, ioInfo);
  }
  // We could dedupe the async info too but conceptually each request is its own await.
  const asyncInfo: ReactAsyncInfo = {
    awaited: ioInfo,
  };
  return [asyncInfo];
}
