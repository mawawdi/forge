import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashboardNotice } from "./DashboardNotice";

describe("DashboardNotice", () => {
  it("shows the coordinator-produced terminal reason and retry guidance", () => {
    render(
      <DashboardNotice
        surface="incomplete"
        error={undefined}
        detail="The approved change has no mutation evidence. Start a new request to retry."
      />,
    );

    expect(screen.getByText("Evidence is incomplete")).toBeVisible();
    expect(screen.getByText(/no mutation evidence/i)).toBeVisible();
    expect(screen.getByText(/start a new request/i)).toBeVisible();
    expect(screen.queryByText(/cannot receive an invented/i)).not.toBeInTheDocument();
  });
});
