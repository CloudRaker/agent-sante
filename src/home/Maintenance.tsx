// Maintenance page (kill switch, Worker var KILL_SWITCH=1). The help numbers stay one tap away.
import { Wrench } from "lucide-react";
import { EmptyState } from "@/components/arc/empty-state/empty-state";
import { EmergencyList } from "@/gate/EmergencyList";
import { useI18n } from "@/i18n";
import styles from "./home.module.css";

export function Maintenance() {
  const { t } = useI18n();
  return (
    <div className={styles.maintenance}>
      <EmptyState
        label={t.maintenance.title}
        icon={<Wrench size={24} strokeWidth={1.75} />}
        title={t.maintenance.title}
        description={t.maintenance.text}
      />
      <EmergencyList />
    </div>
  );
}
