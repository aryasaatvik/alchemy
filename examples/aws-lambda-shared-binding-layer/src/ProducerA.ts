import * as Lambda from "alchemy/AWS/Lambda";
import { producer } from "./producer.ts";

export default class ProducerA extends Lambda.Function<ProducerA>()(
  "ProducerA",
  { main: import.meta.url, functionUrl: true },
  producer("ProducerA"),
) {}
