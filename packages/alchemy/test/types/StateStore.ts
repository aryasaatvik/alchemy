import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AWS from "@/AWS/index.ts";
import * as Alchemy from "@/index.ts";
import type { StackProps } from "@/Stack.ts";
import type { State } from "@/State/State.ts";

type Expect<T extends true> = T;
type AwsStateOutput = Layer.Success<ReturnType<typeof AWS.state>>;
type _ProvidesState = Expect<State extends AwsStateOutput ? true : false>;
type _KeepsAwsServicesPrivate = Expect<AwsStateOutput extends State ? true : false>;

// A stack may select its store by stage without exposing the AWS layer's internals.
const selectedState: StackProps<never>["state"] = Layer.unwrap(
  Alchemy.Stage.pipe(
    Effect.map((stage) =>
      stage === "local" ? Alchemy.localState() : AWS.state({ prefix: "app" }),
    ),
  ),
);

void selectedState;
