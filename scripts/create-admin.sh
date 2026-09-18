#!/bin/bash
sudo docker exec -i livora-api-service-livora_api-1 node scripts/create_admin.js "$@"