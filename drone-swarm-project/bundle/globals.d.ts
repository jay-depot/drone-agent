import type * as ReactNS from 'react';

declare global {
  // eslint-disable-next-line no-var
  var React: typeof ReactNS;

  type ReactNode = ReactNS.ReactNode;
  type ReactElement = ReactNS.ReactElement;

  namespace JSX {
    type Element = ReactNS.JSX.Element;
    type ElementType = ReactNS.JSX.ElementType;
    interface ElementClass extends ReactNS.JSX.ElementClass {}
    interface ElementAttributesProperty
      extends ReactNS.JSX.ElementAttributesProperty {}
    interface ElementChildrenAttribute
      extends ReactNS.JSX.ElementChildrenAttribute {}
    interface IntrinsicAttributes extends ReactNS.JSX.IntrinsicAttributes {}
    interface IntrinsicElements extends ReactNS.JSX.IntrinsicElements {}
  }
}

export {};
