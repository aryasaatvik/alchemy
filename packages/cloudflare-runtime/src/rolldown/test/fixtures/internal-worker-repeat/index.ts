import { alphabeticallyFirst } from "./alphabetically-first.ts";
import { alphabeticallyLast } from "./alphabetically-last.ts";

export default {
  fetch() {
    return new Response(`${alphabeticallyFirst}${alphabeticallyLast}`);
  },
};
