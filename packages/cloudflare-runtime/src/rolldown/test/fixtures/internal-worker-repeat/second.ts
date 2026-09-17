import { alphabeticallyLast } from "./alphabetically-last.ts";
import { alphabeticallyFirst } from "./alphabetically-first.ts";

export default {
  fetch() {
    return new Response(`${alphabeticallyLast}${alphabeticallyFirst}`);
  },
};
