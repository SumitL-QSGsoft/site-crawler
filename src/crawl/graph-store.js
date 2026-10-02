// Owns the crawl's navigation graph (nodes = screens, edges = how one screen was reached from
// another) instead of the crawler passing two loose arrays around and mutating them ad hoc.
export class GraphStore {
  #nodes = [];
  #edges = [];

  constructor({ nodes = [], edges = [] } = {}) {
    this.#nodes = [...nodes];
    this.#edges = [...edges];
  }

  addNode({ id, url, title, depth }) {
    const index = this.#nodes.findIndex((node) => node.id === id);
    if (index !== -1) this.#nodes[index] = { id, url, title, depth };
    else this.#nodes.push({ id, url, title, depth });
  }

  addEdge({ from, to, label }) {
    if (!from) return;
    if (!this.#edges.some((edge) => edge.from === from && edge.to === to && edge.label === label)) {
      this.#edges.push({ from, to, label });
    }
  }

  clearOutgoing(id) {
    this.#edges = this.#edges.filter((edge) => edge.from !== id);
  }

  retainReachable(rootId) {
    const seen = new Set([rootId]);
    const pending = [rootId];
    while (pending.length) {
      const from = pending.pop();
      for (const edge of this.#edges.filter((entry) => entry.from === from)) {
        if (seen.has(edge.to)) continue;
        seen.add(edge.to);
        pending.push(edge.to);
      }
    }
    this.#nodes = this.#nodes.filter((node) => seen.has(node.id));
    this.#edges = this.#edges.filter((edge) => seen.has(edge.from) && seen.has(edge.to));
  }

  get nodes() {
    return this.#nodes;
  }

  get edges() {
    return this.#edges;
  }

  toJSON() {
    return { nodes: this.#nodes, edges: this.#edges };
  }
}
