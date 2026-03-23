import { NavLink } from "react-router";
import { ModeToggle } from "./mode-toggle";

export default function Header() {
  const links = [{ to: "/", label: "Play" }] as const;

  return (
    <div>
      <div className="flex flex-row items-center justify-between px-3 py-2">
        <nav className="flex items-center gap-4">
          <span className="text-lg font-bold tracking-tight">
            💣 Minesweeper
          </span>
          {links.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `text-sm transition-colors ${isActive ? "text-foreground font-semibold" : "text-muted-foreground hover:text-foreground"}`
              }
              end
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <ModeToggle />
        </div>
      </div>
      <hr className="border-border" />
    </div>
  );
}
