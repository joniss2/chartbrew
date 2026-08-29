#!/bin/bash
mysql -u root <<-EOSQL
  CREATE DATABASE IF NOT EXISTS \`${BOOKING_DB_NAME:-booking_agent}\`
    CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
  GRANT ALL PRIVILEGES ON \`${BOOKING_DB_NAME:-booking_agent}\`.* TO '${MYSQL_USER}'@'%';
  FLUSH PRIVILEGES;
EOSQL
