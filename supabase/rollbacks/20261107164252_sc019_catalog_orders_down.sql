-- Operational rollback: stop new catalog purchases. Keep settlement available
-- for existing obligations, preserve accounting and previously purchased units.
-- Do not disable skill-test metering if any units have been sold.
begin;
update sc19_commerce.settings set enabled=false;
commit;
