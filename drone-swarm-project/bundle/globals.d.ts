import type * as ReactNS from 'react';

declare global {
  var React: typeof ReactNS;

  namespace JSX {
    type Element = ReactNS.JSX.Element;
    type ElementType = ReactNS.JSX.ElementType;
    type ElementClass = ReactNS.JSX.ElementClass;
    type ElementAttributesProperty = ReactNS.JSX.ElementAttributesProperty;
    type ElementChildrenAttribute = ReactNS.JSX.ElementChildrenAttribute;
    type IntrinsicAttributes = ReactNS.JSX.IntrinsicAttributes;
    type IntrinsicElements = ReactNS.JSX.IntrinsicElements;
  }
}

export {};
