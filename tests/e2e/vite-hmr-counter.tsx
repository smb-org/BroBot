import { useState, type ReactElement } from "react";

export const Counter = (): ReactElement => {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount((current) => current + 1)}>Count {count}</button>;
};
