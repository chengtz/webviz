// @flow
//
//  Copyright (c) 2018-present, GM Cruise LLC
//
//  This source code is licensed under the Apache License, Version 2.0,
//  found in the LICENSE file in the root directory of this source tree.
//  You may not use this file except in compliance with the License.

// this type mirrors the MessageChannel api which is available on
// instances of web-workers as well as avaiable on 'global' within a worker

export type Channel = {
  postMessage: (data: any, transfer?: any[]) => void,
  onmessage?: (ev: MessageEvent) => void,
};

const RESPONSE = "$$RESPONSE";
const ERROR = "$$ERROR";

// helper function to create linked channels for testing
export function createLinkedChannels(): { local: Channel, remote: Channel } {
  const local: Channel = {
    postMessage(data: any, transfer?: Array<ArrayBuffer>) {
      const ev = new MessageEvent("message", { data });
      // eslint-disable-next-line no-use-before-define
      if (remote.onmessage) {
        remote.onmessage(ev); // eslint-disable-line no-use-before-define
      }
    },
  };

  const remote: Channel = {
    postMessage(data: any, transfer?: Array<ArrayBuffer>) {
      const ev = new MessageEvent("message", { data });
      if (local.onmessage) {
        local.onmessage(ev);
      }
    },
  };
  return { local, remote };
}

// This class allows you to hook up bi-directional async calls across web-worker
// boundaries where a single call to or from a worker can 'wait' on the response.
// Errors in receivers are propigated back to the caller as a rejection.
// It also supports returning transferables over the web-worker postMessage api,
// which was the main shortcomming with the worker-rpc npm module.
// To attach rpc to an instance of a worker in the main thread:
//   const rpc = new Rpc(workerInstace);
// To attach rpc within an a web worker:
//   const rpc = new Rpc(global);
// Check out the tests for more examples.
export default class Rpc {
  static transferables = "$$TRANSFERABLES";
  _channel: Channel;
  _messageId: number = 0;
  _pendingCallbacks: { [number]: (any) => void } = {};
  _receivers: Map<string, (any) => any> = new Map();

  constructor(channel: Channel) {
    this._channel = channel;
    if (this._channel.onmessage) {
      throw new Error("channel.onmessage is already set. Can only use one Rpc instance per channel.");
    }
    this._channel.onmessage = this._onChannelMessage;
  }

  _onChannelMessage = (ev: MessageEvent) => {
    const { id, topic, data } = (ev.data: any);
    if (topic === RESPONSE) {
      this._pendingCallbacks[id](ev.data);
      delete this._pendingCallbacks[id];
      return;
    }
    // invoke the receive handler in a promise so if it throws synchronously we can reject
    new Promise((resolve, reject) => {
      const handler = this._receivers.get(topic);
      if (!handler) {
        throw new Error(`no receiver registered for ${topic}`);
      }
      // This works both when `handler` returns a value or a Promise.
      resolve(handler(data));
    })
      .then((result) => {
        if (!result) {
          return this._channel.postMessage({ topic: RESPONSE, id });
        }
        const transferables = result[Rpc.transferables];
        delete result[Rpc.transferables];
        const message = {
          topic: RESPONSE,
          id,
          data: result,
        };
        this._channel.postMessage(message, transferables);
      })
      .catch((err) => {
        const message = {
          topic: RESPONSE,
          id,
          data: {
            [ERROR]: true,
            message: err.message,
          },
        };
        this._channel.postMessage(message);
      });
  };

  // Send a message across the rpc boundary to a receiver on the other side.
  // This returns a promise for the receiver's response.  If there is no registered
  // receiver for the given topic, this method throws.
  send<TResult>(topic: string, data: any, transfer?: ArrayBuffer[]): Promise<TResult> {
    const id = this._messageId++;
    const message = { topic, id, data };
    const result = new Promise((resolve, reject) => {
      this._pendingCallbacks[id] = (info) => {
        if (info.data && info.data[ERROR]) {
          reject(new Error(info.data.message));
        } else {
          resolve(info.data);
        }
      };
    });
    this._channel.postMessage(message, transfer);
    return result;
  }

  // Register a receiver for a given message on a topic.
  // Only one receiver can be registered per topic, and currently
  // 'deregistering' a receiver is not supported.
  receive<T, TOut>(topic: string, handler: (T) => TOut) {
    if (this._receivers.has(topic)) {
      throw new Error(`Receiver already registered for topic: ${topic}`);
    }
    this._receivers.set(topic, handler);
  }
}