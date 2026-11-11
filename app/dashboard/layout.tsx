import { WorkspaceNavigation } from "../components/workspace-navigation";

export default function DashboardLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <><WorkspaceNavigation />{children}</>;
}
