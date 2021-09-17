import { PublicKey } from "@solana/web3.js";
import {
  Schema,
  deserialize,
  BinaryReader,
  deserializeUnchecked,
  serialize,
} from "borsh";
import BN from "bn.js";
import { AccountTag } from "./market_state";
import { getPriceFromKey } from "./utils";

///////////////////////////////////////////////
////// Nodes and Slab
///////////////////////////////////////////////

export class BytesSlab {
  buffer: Buffer | Uint8Array;

  constructor(buf: Uint8Array) {
    this.buffer = buf;
  }

  borshDeserialize(reader: BinaryReader) {
    this.buffer = reader.buf.slice(reader.offset);
  }
}

export class InnerNode {
  prefixLen: number;
  key: BN;
  children: number[];
  static CHILD_OFFSET = 20;
  static CHILD_SIZE = 4;

  static schema: Schema = new Map([
    [
      InnerNode,
      {
        kind: "struct",
        fields: [
          ["prefixLen", "u32"],
          ["key", "u128"],
          ["children", [2]],
        ],
      },
    ],
  ]);

  constructor(arg: { prefixLen: number; key: BN; children: number[] }) {
    this.prefixLen = arg.prefixLen;
    this.key = arg.key;
    this.children = arg.children;
  }
}

export class LeafNode {
  key: BN;
  callBackInfo: number[];
  assetQuantity: BN;

  constructor(arg: { key: BN; callBackInfo: number[]; assetQuantity: BN }) {
    this.key = arg.key;
    this.callBackInfo = arg.callBackInfo;
    this.assetQuantity = arg.assetQuantity;
  }
  static deserialize(callbackInfoLen: number, data: Buffer) {
    return new LeafNode({
      key: new BN(data.slice(0, 16), "le"),
      callBackInfo: [...data.slice(16, 16 + callbackInfoLen)],
      assetQuantity: new BN(
        data.slice(16 + callbackInfoLen, 24 + callbackInfoLen),
        "le"
      ),
    });
  }
}

export class FreeNode {
  next: number;

  static schema: Schema = new Map([
    [
      FreeNode,
      {
        kind: "struct",
        fields: [["next", "u32"]],
      },
    ],
  ]);

  constructor(arg: { next: number }) {
    this.next = arg.next;
  }
}

export function parseNode(
  callbackinfoLen: number,
  data: Buffer
): undefined | FreeNode | LeafNode | InnerNode {
  switch (data[0]) {
    case 0:
      throw new Error("node is unitialized");
    case 1:
      return deserializeUnchecked(InnerNode.schema, InnerNode, data.slice(1));
    case 2:
      return LeafNode.deserialize(callbackinfoLen, data.slice(1));
    case 3:
      return deserializeUnchecked(FreeNode.schema, FreeNode, data.slice(1));
    case 4:
      return deserializeUnchecked(FreeNode.schema, FreeNode, data.slice(1));
  }
}

export class SlabHeader {
  accountTag: AccountTag;
  bumpIndex: BN;
  freeListLen: BN;
  freeListHead: number;
  rootNode: number;
  leafCount: BN;
  marketAddress: PublicKey;

  static LEN: number = 65;

  static schema: Schema = new Map([
    [
      SlabHeader,
      {
        kind: "struct",
        fields: [
          ["accountTag", "u8"],
          ["bumpIndex", "u64"],
          ["freeListLen", "u64"],
          ["freeListHead", "u32"],
          ["rootNode", "u32"],
          ["leafCount", "u64"],
          ["marketAddress", [32]],
        ],
      },
    ],
  ]);

  constructor(arg: {
    accountTag: number;
    bumpIndex: BN;
    freeListLen: BN;
    freeListHead: number;
    rootNode: number;
    leafCount: BN;
    marketAddress: Uint8Array;
  }) {
    this.accountTag = arg.accountTag as AccountTag;
    this.bumpIndex = arg.bumpIndex;
    this.freeListLen = arg.freeListLen;
    this.freeListHead = arg.freeListHead;
    this.rootNode = arg.rootNode;
    this.leafCount = arg.leafCount;
    this.marketAddress = new PublicKey(arg.marketAddress);
  }

  static deserialize(data: Buffer) {
    return deserialize(this.schema, SlabHeader, data);
  }
}

export class Slab {
  header: SlabHeader;
  callBackInfoLen: number;
  slotSize: number;
  data: Buffer;

  // @ts-ignore
  static schema: Schema = new Map([
    [
      SlabHeader,
      {
        kind: "struct",
        fields: [
          ["accountTag", "u8"],
          ["bumpIndex", "u64"],
          ["freeListLen", "u64"],
          ["freeListHead", "u32"],
          ["rootNode", "u32"],
          ["leafCount", "u64"],
          ["marketAddress", [32]],
        ],
      },
    ],
    [
      Slab,
      {
        kind: "struct",
        fields: [["header", SlabHeader]],
      },
    ],
  ]);

  constructor(arg: {
    header: SlabHeader;
    callBackInfoLen: number;
    data: Buffer;
  }) {
    this.header = arg.header;
    this.callBackInfoLen = arg.callBackInfoLen;
    this.slotSize = Math.max(arg.callBackInfoLen + 8 + 16 + 1, 32);
    this.data = arg.data;
  }

  // Get a specific node (i.e fetch 1 order)
  getNodeByKey(key: number) {
    let pointer = this.header.rootNode;
    let offset = SlabHeader.LEN;
    while (true) {
      let node = parseNode(
        this.callBackInfoLen,
        this.data.slice(
          offset + pointer * this.slotSize,
          offset + (pointer + 1) * this.slotSize
        )
      );
      if (node instanceof InnerNode) {
        const critBitMaks = (1 << 127) >> node.prefixLen;
        let critBit = key & critBitMaks;
        pointer = node.children[critBit];
      }
      if (node instanceof LeafNode) {
        return node;
      }
    }
  }

  getMinMax(max: boolean) {
    let pointer = this.header.rootNode;
    let offset = SlabHeader.LEN;
    let critBit = max ? 1 : 0;
    while (true) {
      let node = parseNode(
        this.callBackInfoLen,
        this.data.slice(
          offset + pointer * this.slotSize,
          offset + (pointer + 1) * this.slotSize
        )
      );
      if (node instanceof InnerNode) {
        pointer = node.children[critBit];
        if (!pointer) pointer = node.children[(critBit + 1) % 2];
      }
      if (node instanceof LeafNode) {
        return node;
      }
    }
  }

  // Descend into the tree following a given direction
  *items(descending = false): Generator<{
    key: BN;
    callBackInfo: number[];
    assetQuantity: BN;
  }> {
    if (this.header.leafCount.eq(new BN(0))) {
      return;
    }
    const stack = [this.header.rootNode];
    while (stack.length > 0) {
      const pointer = stack.pop();
      if (!pointer) throw "unreachable!";
      let offset = SlabHeader.LEN + pointer * this.slotSize;
      const node = parseNode(
        this.callBackInfoLen,
        this.data.slice(offset, offset + this.slotSize)
      );
      if (node instanceof LeafNode) {
        yield node;
      } else if (node instanceof InnerNode) {
        if (descending) {
          stack.push(node.children[0], node.children[1]);
        } else {
          stack.push(node.children[1], node.children[0]);
        }
      }
    }
  }

  // Get the market order depth
  getL2Depth(depth: number, max: boolean) {
    const levels: [BN, BN][] = []; // (price, size)
    for (const { key, assetQuantity } of this.items(!max)) {
      const price = getPriceFromKey(key);
      if (levels.length > 0 && levels[levels.length - 1][0].eq(price)) {
        levels[levels.length - 1][1].iadd(assetQuantity);
      } else if (levels.length === depth) {
        break;
      } else {
        levels.push([price, assetQuantity]);
      }
    }
    return levels;
  }

  // Get the atmost maxNbOrders present best or worst orders by price.
  getMinMaxNodes(maxNbOrders: number, minOrMax: boolean) {
    const minMaxOrders: LeafNode[] = [];
    for (const leafNode of this.items(!minOrMax)) {
      if (minMaxOrders.length === maxNbOrders) {
        break;
      }
      minMaxOrders.push(leafNode);
    }
    return minMaxOrders;
  }
}
