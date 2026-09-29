// The wall floor: does a wall name anything beyond the task it was given?

// A wall has to name something. "Could not prove the lemma" on the item "prove the lemma" found
// no structure, it found the task. The floor is mechanical: the wall must contain at least one
// word of four letters or more that is neither in the item's own id, label and text nor a word
// every wall contains. The judge reads what clears the floor; this only stops the emptiest
// case from parking an item on nothing.
export const WALL_NOISE = new Set(('mathlib lean prove proved proof proofs theorem lemma lemmas missing does have cannot could ' +
  'need needs needed without there which that this with from into sorry statement exists exist ' +
  'done finish finished work item task attempt because still only also would should must').split(' '));
const words = (t) => new Set(String(t ?? '').toLowerCase().match(/[a-z][a-z0-9_'-]{3,}/g) ?? []);
export function wallNamesNothing(wall, w) {
  const own = new Set([...words(w.id), ...words(w.label), ...words(w.what)]);
  for (const t of words(wall)) if (!own.has(t) && !WALL_NOISE.has(t)) return false;
  return true;
}
