import type { ReactElement } from "react";

import { CHANNEL_ROLES, ROLE_MATRIX_ACTIONS, roleMatrixAllows } from "../contracts/values";
import { dashboardCommonTexts } from "./locale";
import { membersTexts } from "./labels";
import { Icon } from "./ui";
import "./members.css";

export const RoleMatrixDisclosure = (): ReactElement => {
  const texts = membersTexts();
  const roles = dashboardCommonTexts().roles;

  return <div className="role-matrix" role="group" aria-label={texts.roleMatrixTitle}>
    <details className="role-matrix__disclosure">
      <summary>{texts.roleMatrixDisclosure}</summary>
      <div className="role-matrix__scroll" tabIndex={0} role="region" aria-label={texts.roleMatrixTitle}>
        <table className="role-matrix__table">
          <thead><tr>
            <th scope="col">{texts.roleMatrixActionHeading}</th>
            {CHANNEL_ROLES.map((role) => <th scope="col" key={role}>{roles[role]}</th>)}
          </tr></thead>
          <tbody>{ROLE_MATRIX_ACTIONS.map((action) => <tr key={action.id}>
            <th scope="row">{texts.roleMatrixActions[action.id]}</th>
            {CHANNEL_ROLES.map((role) => {
              const allowed = roleMatrixAllows(role, action.access);
              return <td key={role}>
                <span className="sr-only">{roles[role]}: {allowed ? texts.roleMatrixAllowed : texts.roleMatrixDenied}</span>
                {allowed
                  ? <Icon name="copied" size={16} />
                  : <Icon name="minus" size={16} />}
              </td>;
            })}
          </tr>)}</tbody>
        </table>
      </div>
    </details>
  </div>;
};
