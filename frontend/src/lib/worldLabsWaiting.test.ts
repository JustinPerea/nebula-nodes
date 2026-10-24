/**
 * The canvas notice when a delete keeps nodes that hold World Labs state
 * (GM - Design, rounds 4 and 4b, and the copy round of 2026-10-24: every node
 * in a several-node delete held, forget form, reads "Couldn't delete them.
 * They're waiting on World Labs. Check Marble and Run History.").
 */
import { describe, expect, it } from 'vitest';
import { NODE_WAITING_FORGET, NODE_WAITING_UNLOCK, deleteRefusalText, heldDeleteText } from './worldLabsWaiting';

describe('heldDeleteText', () => {
  it("every node held, forget: GM's 2026-10-24 line", () => {
    expect(heldDeleteText(2, false, 2))
      .toBe("Couldn't delete them. They're waiting on World Labs. Check Marble and Run History.");
    expect(heldDeleteText(5, false, 5))
      .toBe("Couldn't delete them. They're waiting on World Labs. Check Marble and Run History.");
  });

  it('the other forms are unchanged', () => {
    expect(heldDeleteText(1, true)).toBe("Couldn't delete the node. It's waiting on World Labs. Check Marble, then unlock it.");
    expect(heldDeleteText(1, false)).toBe("Couldn't delete it. It's waiting on World Labs. Check Marble, then forget it in Run History.");
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
