import { useId, type ReactNode } from "react";

export interface SectionProps {
  title: ReactNode;
  children: ReactNode;
  className?: string;
  headingAction?: ReactNode;
  headingLevel?: "h2" | "h3";
  variant?: "default" | "inspector";
}

export function Section({ title, children, className, headingAction, headingLevel = "h2", variant = "default" }: SectionProps) {
  const headingId = useId();
  const Heading = headingLevel;
  const classes = ["ui-section", variant === "inspector" ? "ui-section--inspector" : undefined, className].filter(Boolean).join(" ");

  return <section data-ui="" className={classes} aria-labelledby={headingId}>
    <div className="ui-section__heading">
      <Heading id={headingId}>{title}</Heading>
      {variant === "inspector"
        ? <>{headingAction}<span className="ui-section__rule" aria-hidden="true" /></>
        : headingAction ?? <span className="ui-section__rule" aria-hidden="true" />}
    </div>
    <div className="ui-section__content">{children}</div>
  </section>;
}
