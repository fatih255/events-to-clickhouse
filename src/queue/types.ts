export interface QueueMessage {
  id: string;
  receiptHandle: string;
  body: string;
  /** How many times SQS has handed this message out, including this time. */
  receiveCount: number;
}

/** The small part of SQS the pipeline uses. Tests swap in an in-memory version. */
export interface Queue {
  /** Sends bodies, splitting into SQS-sized batches. Throws if any message can't be sent. */
  send(bodies: string[]): Promise<void>;
  /** Returns up to `max` messages (SQS caps this at 10), waiting up to `waitSeconds`. */
  receive(max: number, waitSeconds: number): Promise<QueueMessage[]>;
  /** Deletes messages. Returns the receipt handles that failed. */
  delete(receiptHandles: string[]): Promise<string[]>;
}
