/**
 * The canvas notice when a delete keeps nodes that hold World Labs state
 * (GM - Design, rounds 4 and 4b, and the copy round of 2026-10-24: every node
 * in a several-node delete held, forget form, reads "Couldn't delete them.
 * They're waiting on World Labs. Check Marble and Run History.").
 */
import { describe, expect, it } from 'vitest';
import { RECOVERY_ID_SAVED_TAIL, WORLD_LABS_NEEDS_CHECK, deleteRefusalText, heldDeleteText } from './worldLabsWaiting';

// The backend's round 13 lines (GM): an unconfirmed start, and a saved recovery ID.
const NODE_WAITING_UNLOCK = WORLD_LABS_NEEDS_CHECK;
const NODE_WAITING_FORGET = `“World Labs Environment”${RECOVERY_ID_SAVED_TAIL}`;

describe('heldDeleteText', () => {
  it("every node held, forget: GM's 2026-10-24 line", () => {
    expect(heldDeleteText(2, false, 2))
      .toBe("Couldn't delete them. They're waiting on World Labs. Check Marble and Run History.");
    expect(heldDeleteText(5, false, 5))
      .toBe("Couldn't delete them. They're waiting on World Labs. Check Marble and Run History.");
  });

  // GM, round 15 of PR #114: the one-node lines get back what round 4's
  // trim dropped, "Couldn't delete “<node>”. <reason line>", with the shared
  // World Labs reason and the button named.
  it("one node: GM's round 15 line, named; 'the node' with no name", () => {
    expect(heldDeleteText(1, true, 1, '“Harbor world”')).toBe(
      "Couldn't delete “Harbor world”. A World Labs run needs your check first. Use the notice at the top of the screen.");
    expect(heldDeleteText(1, false, 1, '“Harbor world”')).toBe(
      "Couldn't delete “Harbor world”. It has a saved World Labs recovery ID. Check the run in Marble, then use “Forget ID” in Run History.");
    expect(heldDeleteText(1, true)).toBe(
      "Couldn't delete the node. A World Labs run needs your check first. Use the notice at the top of the screen.");
    expect(heldDeleteText(1, false)).toBe(
      "Couldn't delete the node. It has a saved World Labs recovery ID. Check the run in Marble, then use “Forget ID” in Run History.");
  });

  it('the several-node forms are unchanged', () => {
    expect(heldDeleteText(2, true, 2)).toBe("Couldn't delete them. They're waiting on World Labs. Check Marble, then unlock them.");
    expect(heldDeleteText(3, true, 2)).toBe("Couldn't delete them. 2 are waiting on World Labs. Check Marble, then unlock them.");
    expect(heldDeleteText(3, true, 1)).toBe("Couldn't delete them. One is waiting on World Labs. Check Marble, then unlock it.");
    expect(heldDeleteText(3, false, 2)).toBe("Couldn't delete them. 2 are waiting on World Labs. Check Marble, then use Run History.");
    expect(heldDeleteText(3, false, 1)).toBe("Couldn't delete them. One is waiting on World Labs. Check Marble, then use Run History.");
  });

  it("the backend's refusal path reads the same line when every refused node is held (forget)", () => {
    expect(deleteRefusalText("Couldn't delete 2 nodes.", 2, [NODE_WAITING_FORGET, NODE_WAITING_FORGET]))
      .toBe("Couldn't delete them. They're waiting on World Labs. Check Marble and Run History.");
    // An unconfirmed start among them is the unlock form, unchanged.
    expect(deleteRefusalText("Couldn't delete 2 nodes.", 2, [NODE_WAITING_FORGET, NODE_WAITING_UNLOCK]))
      .toBe("Couldn't delete them. They're waiting on World Labs. Check Marble, then unlock them.");
  });
});

describe("GM's World Labs wording (round 13 of PR #114), exact", () => {
  it('the lines, labels and dialog', async () => {
    const wl = await import('./worldLabsWaiting');
    expect(wl.WORLD_LABS_STARTING).toBe('A World Labs run is still starting. Try again in a moment.');
    expect(wl.WORLD_LABS_NEEDS_CHECK).toBe('A World Labs run needs your check first. Use the notice at the top of the screen.');
    expect(`“Harbor world”${wl.RECOVERY_ID_SAVED_TAIL}`).toBe(
      '“Harbor world” has a saved World Labs recovery ID. Check the run in Marble, then forget the ID in Run History.');
    expect(wl.UNLOCK_LABEL).toBe("I've checked Marble");
    // Round 14: the name comes quoted from recordNodeName.
    const nodes = [{ id: 'n2', data: { label: 'Harbor world' } }];
    expect(wl.unlockAriaLabel(wl.recordNodeName(nodes, 'n2'))).toBe("I've checked Marble. Unlock “Harbor world”.");
    expect(wl.FORGET_LABEL).toBe('Forget ID');
    expect(wl.forgetHeading(wl.recordNodeName(nodes, 'n2'))).toBe('Forget the recovery ID for “Harbor world”?');
  });

  it("round 14's gap wording (GM - Design, 2026-10-27), exact", async () => {
    const wl = await import('./worldLabsWaiting');
    const { noteNodeLabels, forgetNodeLabelsForTests } = await import('./lastNodeLabels');
    forgetNodeLabelsForTests();
    expect(wl.UNLOCK_RUN_ARIA).toBe("I've checked Marble. Unlock this World Labs run.");
    expect(wl.forgetAriaLabel(wl.recordNodeName([{ id: 'n2', data: { label: 'Harbor world' } }], 'n2', true)))
      .toBe('Forget the recovery ID for “Harbor world”');
    expect(wl.recordNodeName([], 'n2')).toBe('A removed World Labs node');
    noteNodeLabels([{ id: 'n2', data: { label: 'Harbor world' } }]);
    expect(wl.recordNodeName([], 'n2')).toBe('“Harbor world”, no longer on the canvas');
    expect(wl.recoveryIdLabel(null)).toBe('Operation ID');
    expect(wl.recoveryIdLabel('world-1')).toBe('World ID');
    forgetNodeLabelsForTests();
    expect(wl.FORGET_BODY).toBe(
      "Only do this after you've checked the run in Marble. Without the ID, Nebula can't stop you from paying for the same run twice.");
  });

  it('a renamed node still reads as a held delete refusal (its card title differs)', () => {
    expect(deleteRefusalText("Couldn't delete the node.", 1, [`“Harbor world”${RECOVERY_ID_SAVED_TAIL}`]))
      .toBe("Couldn't delete “Harbor world”. It has a saved World Labs recovery ID. Check the run in Marble, then use “Forget ID” in Run History.");
  });
});
