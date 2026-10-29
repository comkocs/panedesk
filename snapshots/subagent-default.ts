/** Exact model-visible additions made by the product's root overflow queue. */

/**
 * Add only queue result fields to an upstream PTC system-prompt snapshot.
 * @param upstream - Complete committed upstream prompt, including its terminal newline.
 * @returns The complete expected prompt with the three queue-capable result declarations.
 */
export function withDefaultSubagentQueue(upstream: string): string {
  const list = '  list_agents: ({\n'
  const activation = '    kind: "activation";\n    subagentId: string;'
  if (upstream.split(list).length !== 2 || upstream.split(activation).length !== 3) {
    throw new Error('Expected one list_agents and two activation result declarations')
  }
  return upstream.replace(list, list
    + '    kind: "queue";\n'
    + '    queuedCount: number;\n'
    + '    earliestQueuedAt: number;\n'
    + '    tickets: {\n'
    + '      ticketId: string;\n'
    + '      position: number;\n'
    + '      queuedAt: number;\n'
    + '    }[];\n'
    + '  } | {\n')
    .replaceAll(activation,
      '    kind: "activation" | "queued";\n'
      + '    subagentId?: string;\n'
      + '    ticketId?: string;\n'
      + '    position?: number;')
}
