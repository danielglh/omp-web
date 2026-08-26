import { Route, Routes } from "react-router-dom";
import { AuthGate } from "./components/auth/AuthGate";
import { AppShell } from "./components/layout/AppShell";
import { SessionDetailPage } from "./pages/SessionDetailPage";
import { SessionListPage } from "./pages/SessionListPage";
import { SettingsPage } from "./pages/SettingsPage";

export function App() {
	return (
		<AuthGate>
			<AppShell>
				<Routes>
					<Route path="/" element={<SessionListPage />} />
					<Route path="/sessions/:sessionId" element={<SessionDetailPage />} />
					<Route path="/settings" element={<SettingsPage />} />
				</Routes>
			</AppShell>
		</AuthGate>
	);
}
