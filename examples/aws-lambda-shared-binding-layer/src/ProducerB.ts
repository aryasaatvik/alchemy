import * as Lambda from "alchemy/AWS/Lambda";
import { producer } from "./producer.ts";

export default class ProducerB extends Lambda.Function<ProducerB>()(
  "ProducerB",
  { main: import.meta.url, functionUrl: true },
  producer("ProducerB"),
) {}
