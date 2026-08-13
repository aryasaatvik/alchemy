/**
 * Cyclic graph node -> stable identity of the strongly-connected component
 * containing it. Acyclic nodes are absent.
 */
export type CycleComponents = ReadonlyMap<string, string>;

/**
 * Compute the cyclic strongly-connected components of a graph.
 *
 * A node belongs to a cyclic SCC iff its component has size > 1, or it has a
 * self-edge (a size-1 SCC that loops back to itself). Each member maps to the
 * lexicographically-smallest FQN in its component, giving consumers a stable
 * identity they can compare without conflating distinct cycles.
 *
 * Implementation is iterative Tarjan's algorithm to avoid blowing the JS
 * call stack on very wide graphs.
 */
export const findCycleComponents = (
  edges: Record<string, readonly string[]>,
): CycleComponents => {
  const cycleComponents = new Map<string, string>();

  let index = 0;
  const indexOf = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];

  type Frame = { node: string; childIdx: number };
  const callStack: Frame[] = [];

  const startNode = (node: string) => {
    indexOf.set(node, index);
    lowlink.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    callStack.push({ node, childIdx: 0 });
  };

  for (const root of Object.keys(edges)) {
    if (indexOf.has(root)) continue;
    startNode(root);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1];
      const children = edges[frame.node] ?? [];
      if (frame.childIdx < children.length) {
        const child = children[frame.childIdx];
        frame.childIdx += 1;
        if (!indexOf.has(child)) {
          startNode(child);
          continue;
        }
        if (onStack.has(child)) {
          lowlink.set(
            frame.node,
            Math.min(lowlink.get(frame.node)!, indexOf.get(child)!),
          );
        }
        continue;
      }

      // All children processed: maybe close an SCC.
      if (lowlink.get(frame.node) === indexOf.get(frame.node)) {
        const scc: string[] = [];
        for (;;) {
          const w = stack.pop()!;
          onStack.delete(w);
          scc.push(w);
          if (w === frame.node) break;
        }
        const only = scc[0];
        const isCyclic = scc.length > 1 || (edges[only] ?? []).includes(only);
        if (isCyclic) {
          const componentId = scc.reduce((smallest, fqn) =>
            fqn < smallest ? fqn : smallest,
          );
          for (const fqn of scc) cycleComponents.set(fqn, componentId);
        }
      }

      // Pop frame and propagate lowlink up to the parent.
      callStack.pop();
      const parent = callStack[callStack.length - 1];
      if (parent) {
        const cur = lowlink.get(parent.node)!;
        const childLow = lowlink.get(frame.node)!;
        if (childLow < cur) lowlink.set(parent.node, childLow);
      }
    }
  }

  return cycleComponents;
};

/** Whether two nodes are peers in the same cyclic SCC. */
export const inSameCycle = (
  components: CycleComponents,
  left: string,
  right: string,
): boolean => {
  const component = components.get(left);
  return component !== undefined && component === components.get(right);
};
