/**
 * Just enough of a DOM to run the storefront script (src/bigcommerce/storefront.ts)
 * in the Workers test pool, which has none: elements with classes,
 * attributes, children and click listeners, and `querySelector` for class
 * selectors joined by descendant combinators (`.a .b.c`).
 */

type Listener = (event: { preventDefault(): void }) => void;

export class FakeNode {
  parentNode: FakeElement | null = null;
  constructor(readonly text = "") {}
  get textContent(): string {
    return this.text;
  }
}

export class FakeElement extends FakeNode {
  className = "";
  href = "";
  method = "";
  action = "";
  type = "";
  name = "";
  value = "";
  childNodes: FakeNode[] = [];
  submitted = 0;
  private readonly attributes = new Map<string, string>();
  private readonly listeners: Listener[] = [];
  private ownText = "";

  constructor(readonly tagName: string) {
    super();
  }

  override get textContent(): string {
    return this.ownText + this.childNodes.map((child) => child.textContent).join("");
  }
  set textContent(text: string) {
    this.ownText = text;
    this.childNodes = [];
  }

  get firstChild(): FakeNode | null {
    return this.childNodes[0] ?? null;
  }
  get nextSibling(): FakeNode | null {
    if (!this.parentNode) return null;
    const siblings = this.parentNode.childNodes;
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get children(): FakeElement[] {
    return this.childNodes.filter((child): child is FakeElement => child instanceof FakeElement);
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  appendChild<T extends FakeNode>(child: T): T {
    return this.insertBefore(child, null);
  }
  insertBefore<T extends FakeNode>(child: T, before: FakeNode | null): T {
    child.parentNode = this;
    const at = before ? this.childNodes.indexOf(before) : -1;
    if (at < 0) this.childNodes.push(child);
    else this.childNodes.splice(at, 0, child);
    return child;
  }
  addEventListener(_type: "click", listener: Listener) {
    this.listeners.push(listener);
  }
  /** Clicks it, returning whether a listener prevented the browser's own navigation. */
  click(): boolean {
    let prevented = false;
    for (const listener of this.listeners) listener({ preventDefault: () => (prevented = true) });
    return prevented;
  }
  submit() {
    this.submitted++;
  }

  private classes(): string[] {
    return this.className.split(/\s+/).filter(Boolean);
  }
  private matchesCompound(compound: string): boolean {
    const wanted = compound.split(".").filter(Boolean);
    return wanted.every((cls) => this.classes().includes(cls));
  }
  private descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }
  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
  querySelectorAll(selector: string): FakeElement[] {
    const parts = selector.trim().split(/\s+/);
    let scope: FakeElement[] = [this];
    for (const part of parts) {
      scope = [...new Set(scope.flatMap((el) => el.descendants().filter((d) => d.matchesCompound(part))))];
    }
    return scope;
  }
}

export class FakeDocument {
  readonly documentElement = new FakeElement("html");
  readonly body = this.documentElement.appendChild(new FakeElement("body"));

  createElement(tag: string) {
    return new FakeElement(tag);
  }
  createTextNode(text: string) {
    return new FakeNode(text);
  }
  querySelector(selector: string) {
    return this.documentElement.querySelector(selector);
  }
  querySelectorAll(selector: string) {
    return this.documentElement.querySelectorAll(selector);
  }
}

/** `el("ul.navUser-section", el("li.navUser-item.navUser-item--account"))` */
export function el(spec: string, ...children: (FakeElement | string)[]): FakeElement {
  const [tag, ...classes] = spec.split(".");
  const element = new FakeElement(tag);
  element.className = classes.join(" ");
  for (const child of children) element.appendChild(typeof child === "string" ? new FakeNode(child) : child);
  return element;
}
