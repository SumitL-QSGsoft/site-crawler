// Owns the crawl's navigation graph (nodes = screens, edges = how one screen was reached from
// another) instead of the crawler passing two loose arrays around and mutating them ad hoc.
export class GraphStore {
  #nodes = [];
  #edges = [];

  addNode({ id, url, title, depth }) {
    this.#nodes.push({ id, url, title, depth });
  }

  addEdge({ from, to, label }) {
    if (!from) return;
    this.#edges.push({ from, to, label });
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
