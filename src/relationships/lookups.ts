import type { FileId } from '../domain/types.ts';
import type { SemanticImportLookup } from '../parser/protocol.ts';
import type { ComponentPlan } from './components.ts';
import type { ImportObservation } from './types.ts';

/** Indexes resolved imports in observation order for the available semantic jobs. */
export async function buildComponentImportLookups(
  plans: readonly ComponentPlan[],
  observations: readonly ImportObservation[],
  checkpoint: () => Promise<void>,
): Promise<ReadonlyMap<FileId, readonly SemanticImportLookup[]>> {
  await checkpoint();
  const lookupsByComponent = new Map<FileId, SemanticImportLookup[]>();
  const componentByMember = new Map<FileId, FileId>();
  let visited = 0;
  for (const plan of plans) {
    const available = plan.status === 'available' && plan.grammar !== null;
    visited += 1;
    if (visited === 256) {
      await checkpoint();
      visited = 0;
    }
    if (!available) continue;
    lookupsByComponent.set(plan.id, []);
    for (const member of plan.members) {
      componentByMember.set(member, plan.id);
      visited += 1;
      if (visited === 256) {
        await checkpoint();
        visited = 0;
      }
    }
  }
  for (const item of observations) {
    const componentId = componentByMember.get(item.importerFileId);
    if (componentId !== undefined && item.status === 'resolved' && item.targetFileId !== null) {
      lookupsByComponent.get(componentId)?.push({
        importerFileId: item.importerFileId,
        importId: item.importId,
        specifier: item.specifier,
        specifierRange: item.specifierRange,
        targetFileId: item.targetFileId,
      });
    }
    visited += 1;
    if (visited === 256) {
      await checkpoint();
      visited = 0;
    }
  }
  await checkpoint();
  return lookupsByComponent;
}
